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
   share of any mark-up. Both already land in `commission_ledger` as separate
   kinds, and it now carries `territory_id`, which is what the royalty will be
   computed from. *(The royalty ledger itself is Phase 2 and is not built yet.)*
2. **The royalty is booked on confirmed settlement**, never on delivery.
   `settlements` carries its territory, so the booking has something to hang off.
   *(Phase 2.)*
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

## What is not built yet

Phase 2 — the royalty ledger, operator settlement to the franchisor, the
franchisor's cross-city view, and operator onboarding and approval. Territory
data is in place for all of it; none of the money side above the operator exists.
