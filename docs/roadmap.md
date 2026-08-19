# Roadmap (suggested build order)

Padala-first, because it carries **no rider cash float** and is the lowest-risk
service to launch. Each phase builds on the shared Supabase backend.

## Phase 0 — Foundations
- Supabase project: Postgres schema (see [data-model.md](data-model.md)), RLS,
  Auth.
- Shared TypeScript layer: generated types, query functions, commission/fee logic.
- Admin: **app_settings** (operating hours, fees, commission rate) + auth.
- Lock [open decisions](open-decisions.md) #2, #3, #6, #8 that change schema.

## Phase 1 — Padala end-to-end (lowest risk)
- Customer web: create Padala request (pickup + dropoff, contacts, fee payer).
- Rider app: incoming order pool, accept, status flow, amount-to-collect.
- Admin: rider applications (approve/reject), live order monitoring.
- Commission = 15% of delivery fee; commission ledger entries on completion.
- Settlement gate + account lock (daily cutoff, mark-as-paid).

## Phase 2 — Food
- Admin: add/edit stores + menus (categories, items, options), per-merchant
  on/off toggle.
- Customer: store/menu browsing, per-item customization, multi-store cart,
  ₱25/store fee math.
- Rider: store contact to call, front-cash flow, COD collection.

## Phase 3 — Pabili
- Customer: Pabili request with estimate + budget cap.
- Rider: update actual amount (receipt total); over-budget handling (decision #5).

## Phase 4 — Payments & live tracking
- Online payments (PayMongo/Xendit or direct GCash/Maya) + rider QR.
- Online-paid orders bypass the rider settlement balance.
- Background GPS on rider app → Supabase Realtime → customer live map + ETA
  (3–5s interval, active-delivery only).

## Phase 5 — Native + polish
- Split customer + rider into React Native / Expo where background capability
  matters.
- Push notifications, saved addresses, order history, earnings view.
- SMS/OTP via Semaphore.

---

### Guiding constraints throughout

- **No merchant onboarding** — admin owns all store/menu data.
- **One backend** — web and mobile orders are the same rows; no syncing.
- **Commission on delivery + store fees only** — goods cost is a pass-through.
- **Track GPS only during active deliveries** — battery + data cost.
