# HQ super admin — design decisions

The franchisor's half of the console: the cities as tenants, what they owe, how
they are running, and the controls that belong to the network rather than to any
one city.

Four pushes, each with its migrations, tests and screens:

| Push | What it added | Migrations |
|---|---|---|
| 1 — lifecycle | 7-state pipeline, onboarding checklist, documents, boundary overlap, config history, audit log | 0090–0097 |
| 2 — money | franchise fee, invoicing, aging, dunning, auto-suspend | 0098–0102 |
| 3 — watching | scorecard, thresholds, alert generators | 0103–0104 |
| 4 — platform | view-as, overrides, integrations, flags, notices, exports | 0105–0109 |
| — | account issuance, and records that outlive people | 0110 |
| — | today means today in the city, not in UTC | 0111 |

The decisions worth writing down are below. Everything else is in the migration
comments, next to the code it explains.

## Roles stayed in functions, not in JWT claims

The obvious modern shape is a `role` claim on the token, read by policies with
`auth.jwt()`. This project resolves the caller through `is_franchisor()`,
`is_staff()` and `current_territory_id()`, which read `profiles`.

83 policies rest on those three functions. Moving to claims would mean rewriting
every one of them, plus a claims hook, plus a story for what happens to a session
issued before a role changed. Functions cost a lookup per policy evaluation and
are cached within a statement; claims would have bought latency and a migration
with no security gain. Kept.

That decision is what makes view-as possible at all — see below.

## View-as is a row, not a URL parameter

The natural implementation is `?hq_view_tenant=<id>`, with the client sending it
along. That cannot work here: RLS resolves the caller's city **inside Postgres**,
from their profile. It never sees a URL, and anything the client asserts is a
suggestion the database has no reason to believe.

So a visit is a row in `hq_view_sessions`, and the three functions above were
taught about it:

| | normally | while viewing |
|---|---|---|
| `is_franchisor()` | true | **false** |
| `is_staff()` | false | **true** |
| `current_territory_id()` | null | the viewed city |

`is_franchisor()` returning false is the part that makes it honest. Left true,
the cross-city policies keep firing and "view as" shows everything, proving
nothing.

Read-only is enforced by `zz_hq_readonly`, a **statement-level** BEFORE trigger
on every public table. Statement-level, so it costs one call per statement rather
than one per row; on every table, so there is no surface anyone forgot. Two
tables are exempt by necessity: `hq_view_sessions` (or a session could never be
closed) and `audit_log` (or the visit could not be recorded).

Postgres on Supabase cannot create event triggers, so new tables do not pick the
guard up automatically. `hq_attach_readonly_guards()` exists for that: **any
migration that adds a public table must call it at the end.** `hq_platform.sql`
asserts that no table was left unguarded, so forgetting fails the test run rather
than shipping a hole.

`begin_view_as()` checks the profile row directly rather than calling
`is_franchisor()` — that function is false mid-session, which would make the
function un-callable twice in a row.

The console reloads on begin and on end. What every query returns changes; there
is no reconciling the rows already on screen.

## Overrides are franchisor-only and cannot run without a reason

`hq_reassign_order`, `hq_cancel_order`, `hq_redispatch_order` do what the
operator's own tools refuse. Each takes a mandatory reason, because the reason is
the one thing the audit log cannot reconstruct from the diff.

Cancelling a **delivered** order removes the rider's commission with it —
otherwise they carry a debt for a job that officially never happened. Once that
commission is settled the money has moved and the database refuses: that is a
refund, and it is a person's decision, not a button.

Re-dispatch clears the declines. Offering an order back to everyone who already
passed on it is offering it to nobody.

## There is no sign-up

Nobody creates their own console account. A franchisee's login is made by the
franchisor on the city's page (**Tenants → a city → Actions → Operator
account**), and the details are handed over out of band; the franchisee changes
the password themselves with "Forgot password?" on the sign-in screen. The
sign-in screen says so, so a new operator does not go looking for a button that
will never exist.

`create-staff` is the only door, and it takes the caller's own token:

| caller | may create | for which city |
|---|---|---|
| franchisor | any staff role, and may appoint the city's operator | the city they name |
| operator | staff roles | **their own**, taken from their profile — a `territoryId` in the request is ignored |
| anyone else | nothing | — |

It calls `is_franchisor()` through the caller's token rather than reading their
profile role, so it answers the same way every RLS policy does. That matters
because `is_franchisor()` is false during a view-as session, and an operator's
branch would otherwise let a franchisor create accounts in a city they are only
supposed to be *looking* at. That case is refused explicitly.

An email that already has an account is reported back rather than failed on: the
answer carries `emailTaken`, and the console offers to give that account the role
instead, leaving its password alone.

The password is generated in the browser, shown once, and never stored anywhere
readable — so it is copied and sent now, or reset later.

## A record of what somebody did outlives the somebody

Fourteen columns across the schema stamp *who did this* — who confirmed a
settlement, ticked a checklist item, acknowledged an alert. Each was a foreign
key to `profiles` with no delete action, which quietly made anyone who had ever
acted **undeletable**; the first sign of it was a raw constraint error when a
console account was removed.

`on delete cascade` would delete the history with the person. `on delete set
null` would keep the history and erase who did it — which, on an append-only
audit log and on a money record, is the one fact worth keeping.

So a "who did it" stamp is treated as a **record, not a relationship**: the id
stays as a plain value and the constraint is gone (`0110`). These columns are
written by triggers and by `auth.uid()`, never typed in, so the integrity the
constraint was buying was not integrity anyone was at risk of losing. Columns
that are genuinely relationships — a rider's profile, a customer's profile, an
open view-as session — keep their cascades.

## "Today" means today in the city

Caught by the suite failing at 22:12 UTC, which is 06:12 the next morning in
Manila. Everything the business records is dated by the city's clock —
`commission_ledger.business_day` is a Manila date. But `current_date` in Postgres
is a **UTC** date, and the two disagree from 16:00 UTC until midnight, which is
midnight to 08:00 in Manila, every day.

A franchisor asking for "the last 30 days up to today" therefore got a window
ending yesterday, and the morning's trading was invisible until eight o'clock.
Not a rounding error — a whole shift missing from the number the franchise is run
on. The same slip aged invoices and expired documents eight hours early.

`business_today(territory)` (`0111`) returns today in that city's timezone, or
the platform's when no city is named, and the aging view, the expiry view, the
overdue lookup and the export defaults all use it. The rule: **never compare
`current_date` against a date the business wrote.**

Still outstanding, and only visible with a city outside the Philippines:
about a dozen places still hardcode `Asia/Manila` when *writing* a business day
(`record_commission_on_delivery`, the scorecard, the invoice run). They agree
with each other and with `business_today()` today, so nothing is inconsistent —
but the second country makes them wrong together. `territories.timezone` already
exists for when that happens.

## Money is never a float

`numeric(12,2)` throughout, and the ledger is append-only. Royalty is booked on
the confirmed settlement of a commission row, not on delivery — a rider who has
not paid has not generated a royalty.

## Settings live where they already lived

`platform_settings` was already the franchisor-owned singleton (0081). The app
versions, support desk and maintenance message were added to it rather than to a
second `platform_config` table that would have to be kept in agreement with it.

Feature flags are a default plus an optional per-city override. Setting a city
back to the platform default **removes** its override, so it follows any future
change to that default; leaving a matching override behind would silently pin it.
An unknown flag reads as **off**, so a typo turns a feature off rather than on.

## Minimum app version is unauthenticated on purpose

`public_config()` is reachable with the anon key, and the `v1-config` function is
deployed `--no-verify-jwt`. A rider whose build is too old often cannot sign in,
and still has to be told why. It returns five fields, chosen in the database, so
the endpoint has no say in what is public.

The gate is optimistic when the lookup fails: a rider mid-shift on a bad
connection must not be locked out of a working app by a timeout.

## Exports are built by the database

`hq_export()` returns CSV **lines**, header first, with the permission check
inside it — so an export from the console and an export from the `hq-export`
endpoint agree on quoting, on timezone and on who may see what. Lines rather than
one blob so the endpoint can stream: a year of deliveries is more than a screen's
worth, which is the entire reason to export it.

Times come out in the city's own timezone. The person reading the spreadsheet is
in that city.

## Maps stayed on Leaflet + OSM

No Google Maps, no new billing. Territories are circles — a centre and a radius —
which is enough to route a pin, cheap to draw, and does not need PostGIS.
`territories_overlap()` compares circles directly.

## What the test harness had to learn

`scripts/db_test.sh` replays every migration and runs `supabase/tests/*.sql`
against a throwaway cluster — 265 assertions.

It originally applied each migration statement by statement, auto-committing.
Supabase's deployment path runs a migration as **one transaction**, and the
difference is not academic: a migration that added an enum value and used it in
the same file passed locally and was rejected live. The harness now runs
`--single-transaction`. Match the deployment path or the harness lies.
