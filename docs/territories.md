# Territories

ServdGo is a franchise: each city has its own operator, who sets their own
commission inside a band the franchisor controls and keeps 70% of what the
platform earns there. This document describes the part that is built — the
database model underneath that — and the rules it enforces.

The plan it comes from is in [franchise-plan.md](./franchise-plan.md).

## The shape

| Thing | Where it lives | Who owns it |
|---|---|---|
| Boundary, fees, hours, payout details | `territories`, one row per city | The operator, except the boundary |
| Commission band every city is held to | `platform_settings` | The franchisor |
| Which city a person works in | `profiles.territory_id` | The franchisor |
| Which city an order, rider, store, ledger row or settlement belongs to | `territory_id` on each | Assigned automatically |

`app_settings` is no longer a table. It is a **view that resolves to the
caller's own territory**, so the apps keep issuing the query they always did and
each operator gets their own numbers back. It is updatable: a save from the admin
settings screen lands on the territory that operator runs, and nowhere else.

## The five rules, and where each is enforced

1. **The royalty base is all platform revenue** — commission plus the operator's
   share of any mark-up. Both land in `commission_ledger`, whose `markup` rows
   already hold the operator's share rather than the whole mark-up, so the base
   is simply the ledger amount whatever its kind. Negative adjustments reduce it.
2. **The royalty is booked on confirmed settlement**, never on delivery. See
   [The royalty](#the-royalty) below.
3. **Commission rates have a floor and a ceiling.**
   `platform_settings.commission_rate_min`/`_max`, enforced by the
   `trg_territory_commission_band` trigger on every insert and update. The admin
   settings screen shows the band rather than letting an operator find it on save.
4. **A delivery belongs to the territory it was picked up in.**
   `territory_for_point()` resolves a coordinate to a city; the
   `orders_assign_territory` trigger stamps it as the order is written. A
   drop-off outside that city's radius is refused, and a Food order whose store
   turns out to be in another city is refused too.
5. **Only the franchisor opens or suspends a territory** — and only they draw the
   boundary. `territory_operator_guard()` rejects both from anyone else, and a
   territory that is not `active` takes no new orders.

## Who sees what

`is_staff()` and `is_admin()` answered *whether*, never *where*, which under a
franchise means one operator reading another's orders, riders, customers and
ledger. Every staff-facing policy now goes through one of:

- `staff_sees(territory)` / `admin_sees(territory)` — for rows that carry a city
- `staff_sees_order(id)`, `staff_sees_store(id)`, `staff_sees_rider(id)`,
  `staff_sees_menu_item(id)` — for rows that reach one through a parent

Each checks `is_franchisor()` first, so the franchisor's access never depends on
their carrying a territory of their own.

Customer and rider ownership rules are unchanged, with one addition that matters:
**the rider pool stops at the city line.** A rider sees pending unclaimed work
only in their own territory, and the claim policy refuses a cross-city grab even
if the order id is known.

Two things are deliberately *not* scoped:

- **Store browsing.** A customer is not a member of a city, so
  `stores_public_read` still returns every available store. Ordering outside a
  territory is refused by the radius guard, so this leaks nothing but a menu.
  Filtering the browse to the customer's own area is a customer-app change.
- **Customer profiles.** Staff can read them regardless of city, otherwise nobody
  could work an order placed by a visitor.

## Running the tests

```
./scripts/db_test.sh
```

Creates a throwaway PostgreSQL cluster, replays every migration into it, and runs
`supabase/tests/`. It needs local PostgreSQL 16 server binaries and touches no
hosted project. `supabase/tests/territory_isolation.sql` stands up two cities 600
km apart and asserts, among other things, that the Cebu operator cannot read,
write, or claim anything in Davao.

## The royalty

Confirming a rider's settlement is exactly what flips
`commission_ledger.settled` from false to true. The royalty is booked off *that
transition*, not off the settlements row, so it holds for every path that settles
a ledger entry — including a payment that clears several days at once, and any
future path nobody has written yet.

```
order delivered ──▶ commission_ledger (unsettled)   nothing owed to the franchisor
rider settles   ──▶ commission_ledger.settled = true ──▶ royalty_ledger entry
operator pays   ──▶ operator_settlements (pending)   nothing cleared yet
franchisor confirms ─▶ royalty_ledger.settled = true
```

| Table | What it holds |
|---|---|
| `royalty_ledger` | One entry per settled commission-ledger row, plus joining fees and adjustments |
| `operator_settlements` | A city paying the franchisor for a period, pending until confirmed |
| `platform_settings.royalty_rate` | The franchisor's share, default 0.30 |
| `platform_settings.royalty_cycle` | `weekly` or `monthly` — what period a city is expected to settle on |

Three properties worth knowing, each covered by a test:

- **The rate is snapshotted onto every entry.** Changing `royalty_rate` reprices
  what happens next and never rewrites what was already booked.
- **Booking is idempotent.** `royalty_ledger.source_ledger_id` is unique, so a
  settlement reversed and re-confirmed cannot book twice.
- **Reversal is handled.** Un-confirming a settlement deletes a royalty that was
  never paid across; if the operator has already paid it, an offsetting entry
  cancels it and both stay on the record.

The amount an operator declares is computed in the database from what is
actually outstanding, not taken from the client. Confirming clears everything
unsettled up to the period end, so one payment does not leave an older peso
hanging.

### Who does what

| | Operator (`admin`) | Franchisor |
|---|---|---|
| See their own city's royalty entries | yes | every city |
| Submit a payment | yes | — |
| Confirm a payment arrived | no | yes |
| Open, suspend or redraw a city | no | yes |
| Appoint an operator | no | yes |
| Move the rate or the commission band | no | yes |

`approve_territory()` refuses a city with no operator, no boundary or no payout
details. Each of those is only discoverable once real orders are running, which
is exactly when it is expensive.

## What is not built yet

- **The customer app is not territory-aware.** It reads fees through
  `app_settings`, which resolves via `effective_territory_id()` — correct while
  exactly one territory is active, and null once a second opens. Before city two
  goes live the customer app has to resolve its territory from the delivery pin
  (`territory_for_point`) and read that city's settings. This is a launch
  blocker for the second city, not for the first.
- **Store browsing is not filtered by city** (see above).
- **Whether operators pay a joining fee on top of the 30% is still an open
  policy question.** The ledger has a `joining_fee` kind and
  `charge_territory_fee()` to record one, so the decision does not need code
  when it is made.
- **Phase 4, the Servd door** — the API for restaurants to book deliveries.
