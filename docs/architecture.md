# Architecture

## One backend, several frontends

Supabase is the single source of truth. On top of it sit thin frontends that all
read/write the same tables. Because everything talks to the same Supabase
project, a web order and a mobile order are **identical rows in the same queue** —
riders can't tell the difference, and there's no syncing to build. The
"connection" between the web site and the mobile app is automatic; it's not an
integration, it's shared state.

```
                         ┌─────────────────────────┐
                         │        Supabase          │
                         │  Postgres + RLS +        │
                         │  Realtime + Auth + Storage│
                         └────────────┬─────────────┘
                                      │  (same tables, same order queue)
        ┌──────────────┬──────────────┼──────────────┬──────────────┐
        │              │              │              │              │
 ┌──────▼─────┐ ┌──────▼─────┐ ┌──────▼─────┐ ┌──────▼──────┐
 │ Customer   │ │ Customer   │ │  Rider     │ │   Admin     │
 │ mobile app │ │ web site   │ │ mobile app │ │  dashboard  │
 │ RN / Expo  │ │ React/Vite │ │ RN / Expo  │ │   web       │
 └────────────┘ └────────────┘ └────────────┘ └─────────────┘
   native,        no install,     native,         no app
   background     browser         background GPS   store
```

### The four frontends

| Frontend | Tech | Why native / web |
|---|---|---|
| Customer mobile app | React Native / Expo | Push notifications, saved addresses, full experience |
| Customer web ordering site | React / Vite (or Next.js) | No download — Facebook link → browse → order. Lowest friction for first-time customers |
| Rider mobile app | React Native / Expo | **Required** for background GPS during active deliveries |
| Admin dashboard | Web | No app store needed |

## Shared code layer

Reuse a shared TypeScript layer across the mobile app and the web site so the
ordering flow isn't written twice:

- **Types** — generated from the Supabase schema.
- **Supabase queries** — data access functions.
- **Business logic** — commission math, fee calculation, cart rules, validation.

## Realtime is a natural fit

Supabase Realtime covers two core requirements without extra infrastructure:

1. **Rider order notifications** — new order rows broadcast to available riders.
2. **Live rider tracking** — rider app broadcasts lat/lng every 3–5s during an
   active delivery; the customer's map subscribes. Track **only during an active
   delivery**, never idle (battery + data cost). Auto-start on pickup, stop on
   delivery.

## Deployment shape

- Customer web + Admin dashboard → Vercel.
- Backend → Supabase (managed).
- Native apps → Expo / app stores (later phase).
- Optional first phase: ship one **PWA with role-based views**
  (customer / rider / admin) to cut build time, then split native later —
  matching the attendance-system pattern.

## Suggested stack

- **Frontend:** React / Vite / TailwindCSS, or Next.js for SSR + one codebase.
- **Backend/DB:** Supabase (Postgres + RLS + Realtime).
- **Payments (later):** PayMongo / Xendit.
- **SMS/notifications:** Semaphore (OTP, order status).
- **Deploy:** Vercel / Railway.

## HQ super admin

The franchisor's half of the console — tenants, invoicing, monitoring, and the
platform controls — is documented separately, with the decisions behind it:
[hq-super-admin.md](./hq-super-admin.md). The three that reach furthest into the
rest of the system:

- **Roles stay in helper functions** (`is_franchisor`, `is_staff`,
  `current_territory_id`), not in JWT claims. 83 policies rest on them.
- **Viewing a city as its operator is a database session**, not a URL parameter:
  those three functions answer differently while it is open, and a
  statement-level trigger on every table refuses writes. Any migration that adds
  a public table must call `hq_attach_readonly_guards()`.
- **Money is `numeric(12,2)`**, never a float, and royalty is booked on
  settlement rather than on delivery.
