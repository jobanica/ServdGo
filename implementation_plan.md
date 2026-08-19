# HQ Super Admin module — implementation plan

**Status: awaiting approval. No code written yet.**

Step 0 investigation is below. The short version: roughly two thirds of this
prompt maps cleanly onto what already exists, under different names, and a
meaningful part of it is already built. But five of its assumptions are simply
not true of this codebase, and one of them — the revenue model — contradicts
code that is already live. Those need your decision before anything is written.

---

## 1. What is actually here

| Prompt assumes | This project |
|---|---|
| Next.js App Router, route handlers, server actions | **Three Vite + React 19 SPAs** (`apps/admin`, `apps/customer-web`, `apps/rider`) on Vercel. No server runtime at all — the only server-side code is Postgres functions and Supabase Edge Functions (Deno) |
| `is_hq` / `tenant_id` **JWT claims** | `profiles.role` + `profiles.territory_id`, read by `is_franchisor()`, `current_territory_id()`, `staff_sees()`. **83 RLS policies** depend on these |
| PostGIS polygons, `ST_Intersects` | PostGIS available but **not installed**. A territory is a **circle**: `service_center_lat/lng` + `service_radius_km`, with `km_between()` and `territory_for_point()` |
| Xendit invoicing + webhook receiver | **No payment gateway anywhere.** Settlement is GCash/Maya by hand with a receipt upload and a human confirmation |
| `recharts` | Not a dependency. `Analytics.tsx` draws its own SVG |
| Leaflet / MapLibre | ✅ **Leaflet 1.9.4 already in all three apps**, OSM tiles |
| pg_cron / pg_net | Both **available, neither installed** |

Docs present: `docs/architecture.md` (not `system_architecture.md`), plus
`data-model.md`, `commission-and-settlement.md`, `territories.md`,
`franchise-plan.md`, `merchant-api.md`, `open-decisions.md`, `roadmap.md`.

### Naming map

| Prompt | Here | State |
|---|---|---|
| `tenants` | `territories` | exists |
| `partner_users` | `profiles` (admin/manager/dispatcher/support + `territory_id`) | exists |
| `deliveries` | `orders` | exists |
| `delivery_events` | `order_status_events` | exists |
| `remittances` | `settlements` | exists |
| `hq_fee_ledger` | `royalty_ledger` | exists (Phase 2) |
| `invoices` | `operator_settlements` | exists (Phase 2) |
| `api_keys` | `merchant_api_keys` | exists (Phase 4) |
| `webhook_deliveries` | `merchant_webhook_deliveries` | exists (Phase 4) |
| `merchants`, `riders` | same names | exist |
| `cod_ledger` | `commission_ledger` | exists, **different meaning** — what a rider *owes*, not COD float held |
| `zones` | — | no such concept; a territory is one circle |
| `dispatch_offers` | — | no offer/accept cycle; open pool, riders claim. `rider_request_events` is the nearest |
| `rider_payouts` | — | **riders are never paid out.** They keep the fee at the door and owe commission |

### Already built — do not rebuild

- **Revenue dashboard**: `franchisor_overview(from, to)` already returns per-city
  volume, platform revenue, royalty booked/settled/due/overdue, last payment.
  `/hq/revenue` is largely a re-presentation of it.
- **Invoicing**: `operator_settlements` + `operator_submit_royalty_settlement()`
  + `franchisor_confirm_royalty_settlement()`. Period, amount computed from the
  ledger, method, reference, receipt, franchisor-only confirmation.
- **API keys**: hash-only storage, `prefix`, `last_used_at`, `revoked_at`,
  create/revoke RPCs, console screen. Missing only the 30-day call count.
- **Webhook outbox**: `merchant_webhook_deliveries` with `attempts`,
  `last_error`, `next_attempt_at`, exponential backoff, `claim`/`complete`.
  Replay is a small addition, not a build.
- **Approval gate**: `approve_territory()` already refuses a city with no
  operator, no boundary or no payout details. The checklist generalises it.
- **Suspension**: `suspend_territory()` + a trigger that refuses new orders for
  a non-active territory while in-flight orders finish. Exactly the behaviour
  asked for in group 2 — it just needs an automatic trigger.

---

## 2. Decisions I need before writing code

The prompt says flag rather than guess. These are the flags.

### Q1 — Revenue model (blocking, and the big one)

The prompt states: *delivery fee split per delivery — rider 75%, HQ 7.5%,
partner 17.5%, snapshotted on each delivery row.*

What is live and tested today is a different model:

- The rider collects **everything** at the door and **owes commission** to the
  operator — the territory's rate, default 15%, on delivery fee + per-store
  fees. The convenience fee is 100% the rider's and is never commissioned.
- The operator's revenue is that commission plus their share of any menu
  mark-up, accruing in `commission_ledger`.
- The franchisor takes **30% of operator revenue**, booked in `royalty_ledger`
  **when a rider's settlement is confirmed** — never on delivery, so nobody is
  billed for money a rider is still holding.

These are not reconcilable by renaming. Adopting 75/7.5/17.5 means rewriting
the commission engine, the settlement flow and the royalty ledger — undoing
Phase 2 and the 31 tests that pin it.

**A.** Keep the live model; treat 75/7.5/17.5 as prose from the other project.
**B.** Migrate to the three-way split (a large, separate piece of work, and the
rider-owes-commission mechanic disappears with it).

*My recommendation: A.* The numbers are close in spirit — HQ 7.5% of a fee is
roughly 30% of a 25% commission — but the mechanics differ completely.

### Q2 — Roles: keep helper functions, or move to JWT claims?

Moving `is_hq` / `tenant_id` into JWT claims means rewriting all 83 policies and
adding a custom access-token hook. It buys one thing: policies stop hitting
`profiles` on every check.

**A.** Keep `is_franchisor()` / `current_territory_id()` / `staff_sees()`.
**B.** Migrate to claims.

*My recommendation: A*, unless you have measured a policy-performance problem.

### Q3 — Territory shape: circles or PostGIS polygons?

Territories are circles today, and `territory_for_point()`, the radius guard and
merchant routing all depend on that. Overlap detection between circles is one
line of arithmetic (`km_between(c1,c2) < r1 + r2`) and needs no extension.

**A.** Circle overlap now. No PostGIS.
**B.** Enable PostGIS, add `service_area geography(Polygon)`, rewrite routing and
the radius guard, and build a polygon editor. Real work, and it changes the
meaning of "outside the delivery area" for customers.

*My recommendation: A now, B when a city's shape genuinely isn't a circle.*

### Q4 — Xendit

There is no payment gateway in this project and Xendit is a paid service; your
own rule says ask first. Today an operator declares a payment (method,
reference, receipt) and the franchisor confirms it — money moves out of band.

**A.** Keep manual confirmation; build aging, dunning and auto-suspension on top
of `operator_settlements`. No new service.
**B.** Integrate Xendit: invoice API, webhook receiver Edge Function, status
sync, auto-reactivate on paid.

*My recommendation: A first* — everything in group 2 except the gateway call
works without it, and B becomes an isolated addition later.

### Q5 — Cron mechanism

No cron exists. Both options are available and uninstalled.

**A.** `pg_cron` + `pg_net`, jobs defined in migrations, no external dependency.
**B.** Vercel Cron → Supabase Edge Function. Needs a Vercel project to own the
schedule; the three existing projects are static SPAs.

*My recommendation: A.* It keeps scheduling versioned with the schema.

### Q6 — Where the HQ pages live

There is no Next.js app. `apps/admin` is a single Vite SPA whose "routes" are
component state — no router, no URL paths, so `/hq/...` does not exist as a
concept today.

**A.** Add the HQ sections to `apps/admin`, franchisor-gated (the console
already switches its whole nav by role — a franchisor sees only Territories).
**B.** Add `react-router-dom` to `apps/admin` and give it real URLs, then nest
HQ under `/hq/*`. Needed anyway for deep links and for the view-as-tenant
param.
**C.** Stand up a fourth app, `apps/hq`, as a separate Vercel project.

*My recommendation: B* — the prompt's `?hq_view_tenant=` and per-page URLs both
assume real routing, and it is a contained change. Say if you would rather have
C for a separate deploy and login.

### Q7 — View-as-tenant

`?hq_view_tenant=` cannot work by itself here: RLS resolves the caller's city
from `profiles.territory_id` in Postgres, not from a URL. Doing it honestly
needs a server-side mechanism — a franchisor-only `hq_view_territory` session
setting that `current_territory_id()` respects, with **every write path refusing
while it is set**, plus an `audit_log` row per session.

That is a change to the function 83 policies depend on. I would rather design it
explicitly than slip it in. Confirm you want it, and I will write it as its own
migration with its own tests.

### Q8 — Terminology in the code

Do you want the schema renamed to HQ/tenant language, or kept as
franchisor/territory? Renaming touches 89 migrations' worth of names, 83
policies, the data layer and six docs.

*My recommendation: keep the existing names in code; use "HQ" and "partner" only
in the UI copy.*

---

## 3. What I would build, assuming A/A/A/A/A/B and Q7 confirmed

Ordered as the prompt requires: migrations + RLS → jobs → API → UI.

### Migrations `[NEW]`

| File | Contents |
|---|---|
| `0090_territory_lifecycle.sql` | Extend `territory_status` to `lead, applied, approved, onboarding, live, suspended, terminated`. Map existing `draft→approved`, `active→live`. Update `approve_territory()`, the new-order guard and every `status = 'active'` reference (**14 call sites** — `territory_for_point`, `effective_territory_id`, quote, routing, policies) |
| `0091_onboarding_checklist.sql` | `territory_onboarding_checklist`; seed the five items per territory; `can_go_live(territory)`; `approve_territory()` refuses unless all done |
| `0092_territory_documents.sql` | `territory_documents` + private Storage bucket `territory-documents` (convention here is kebab-case private buckets: `rider-docs`, `store-assets`); expiry view for < 30 days |
| `0093_territory_overlap.sql` | `territories_overlap()` on circles; trigger rejecting a boundary that overlaps another live territory, naming it |
| `0094_config_history.sql` | `territory_config_history` + trigger on `commission_rate`, `markup_operator_share`, `franchise_fee_monthly` |
| `0095_franchise_fee.sql` | `territories.franchise_fee_monthly`, `grace_days` (default 7), `timezone` (default `Asia/Manila`) — **13 hardcoded `Asia/Manila` references** become territory-aware |
| `0096_audit_log.sql` | `audit_log`, append-only (`revoke update, delete`), HQ + tenant read policies |
| `0097_alerts.sql` | `alerts` with `dedupe_key`, severity, `acknowledged_by`; unique index on open alerts per dedupe key |
| `0098_scorecard.sql` | `territory_scorecard` materialised view — 7/30-day assign/pickup/deliver minutes, completion %, failed/cancelled %, unremitted COD, remittance variance; `scorecard_thresholds` global + per-territory; `at_risk` |
| `0099_platform_admin.sql` | `platform_config` (incl. `min_rider_app_version`), `feature_flags` + overrides, `announcements` + `announcement_reads` |
| `0100_invoice_aging.sql` | Aging buckets and dunning state on `operator_settlements`; `overdue_days()`; manual adjustments already exist via `charge_territory_fee()` — add the mandatory `note` constraint |
| `0101_api_key_usage.sql` | `merchant_api_key_usage` daily rollup for the 30-day call count |
| `0102_hq_view_as.sql` | *(only if Q7 = yes)* view-as-territory session mechanism + write-blocking + audit |
| `0103_cron_jobs.sql` | `pg_cron` + `pg_net`; schedule: scorecard refresh /15min, alert generators, daily overdue sweep, monthly invoice run |

### Tests `[NEW]`
`supabase/tests/hq_lifecycle.sql`, `hq_alerts.sql`, `hq_audit.sql`,
`hq_view_as.sql` — same harness as the existing three (`npm run test:db`,
currently 117 checks).

### Data layer `[NEW]` — `packages/supabase/src/`
`lifecycle.ts`, `documents.ts`, `alerts.ts`, `scorecard.ts`, `audit.ts`,
`platformAdmin.ts`, `announcements.ts`, `exports.ts` · `[MODIFY]` `index.ts`,
`territories.ts`, `royalty.ts`, `merchants.ts`

### Edge functions `[NEW]`
`hq-invoice-run`, `hq-alert-sweep`, `hq-suspend-overdue`, `hq-export` (streamed
CSV) · `[NEW]` unauthenticated `v1-config` for `min_rider_app_version`

### Admin app
`[MODIFY]` `apps/admin/package.json` (+`react-router-dom`, +`recharts`),
`App.tsx` (router), `AdminGate.tsx`, `packages/shared/src/roles.ts` (HQ sections)
`[NEW]` `apps/admin/src/hq/` — `Overview`, `Tenants`, `TenantDetail` (Overview /
Checklist / Documents / Territory map / Rev-share / Actions), `Revenue`,
`Invoices`, `Scorecard`, `Alerts`, `Cod`, `Merchants`, `Webhooks`, `ApiKeys`,
`Settings`, `Announcements`, `Audit`, `ViewAsBanner`
`[NEW]` `apps/rider/src/VersionGate.tsx` — min-version check at launch

### Docs `[MODIFY]`
`docs/architecture.md` (append design decisions — the prompt says
`system_architecture.md`; this project's file is `architecture.md`),
`docs/data-model.md`, `docs/territories.md`, `DEPLOYMENT.md`

**Seed** `[NEW]` `supabase/seed/hq_demo.sql` — 3 territories across the
lifecycle, riders, orders, ledger, alerts, so every HQ page has content.

---

## 4. Scale and sequencing

This is roughly **14 migrations, ~18 new UI screens, 4 edge functions and 4 test
suites** — several times the size of any one phase so far. I would rather ship it
in four reviewable pushes than one:

1. **Lifecycle** — status pipeline, checklist, documents, overlap, config history
2. **Money** — franchise fee, aging, dunning, auto-suspend, invoice run
3. **Watching** — scorecard, alerts, COD health, overview map
4. **Platform** — audit, view-as, webhooks replay, keys, settings, announcements,
   exports

Each lands with its migrations, tests and UI together and `npm run build` green.

---

## 5. Answer these and I will start

1. **Q1 revenue model** — keep live model (A) or rebuild to 75/7.5/17.5 (B)?
2. **Q2 roles** — keep helper functions (A) or JWT claims (B)?
3. **Q3 territory shape** — circles (A) or PostGIS polygons (B)?
4. **Q4 Xendit** — manual now (A) or integrate (B)?
5. **Q5 cron** — pg_cron (A) or Vercel Cron (B)?
6. **Q6 HQ location** — in `apps/admin` with a router (B), no router (A), or a
   separate `apps/hq` (C)?
7. **Q7 view-as-tenant** — build it, knowing it modifies `current_territory_id()`?
8. **Q8 naming** — keep territory/franchisor in code (recommended) or rename?
9. **Sequencing** — four pushes as above, or all at once?

---

## Built

All four pushes are in. What actually shipped differs from the table above in
file numbering and in a few decisions taken while building; the design decisions
are recorded in [docs/hq-super-admin.md](docs/hq-super-admin.md).

| Push | Migrations | Tests |
|---|---|---|
| 1 — lifecycle | 0090–0097 | `hq_lifecycle.sql` (24) |
| 2 — money | 0098–0102 | `hq_billing.sql` (26) |
| 3 — watching | 0103–0104 | `hq_monitoring.sql` (25) |
| 4 — platform | 0105–0109 | `hq_platform.sql` (29), `hq_admin.sql` (40) |

262 database assertions in total (`npm run test:db`), plus `npm test`,
`npm run typecheck` and `npm run build` across the three apps.

**Q7 was answered yes**, and view-as was built as its own migration with its own
tests, as promised: `0105_view_as_tenant.sql` and `supabase/tests/hq_platform.sql`.
