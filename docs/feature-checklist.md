# Feature Checklist by App

## Customer App (mobile + web)

- [ ] Store + menu browsing, grouped by **category/menu titles**
- [ ] **Per-item customization** (options, variations, add-ons, notes)
- [ ] Cart supporting **multiple stores in one order** (drives ₱25/store logic)
- [ ] **Pabili request** creation with budget cap + notes
- [ ] **Padala request** creation (pickup + dropoff, contacts, item, fee payer)
- [ ] Delivery address / location
- [ ] **Mobile contact number** — required, for rider calls + OTP
- [ ] Order tracking + status (accepted, preparing, picked up, on the way, delivered)
- [ ] **Live rider location on a map** + ETA once on the way
- [ ] **Payment options:** COD **and online** (GCash / Maya / card via PayMongo/
      Xendit, or scan rider QR). Online-paid orders show as already settled
- [ ] Order history

## Rider App

- [ ] **Rider application / onboarding** — apply with name, mobile, ID, vehicle;
      admin approves before accepting orders. Pending/approved/rejected states
- [ ] **Incoming order notifications** + accept/decline
- [ ] Order + Pabili/Padala details (store, items, address, customer contact)
- [ ] Store contact number to **call for prep**
- [ ] **Amount-to-collect** display (goods cost + delivery fee), with ability to
      update actual Pabili spend
- [ ] **Rider QR code** — personal QR for online pay, shown at drop-off
- [ ] Status updates through the flow
- [ ] **Commission balance owed + daily settlement** — running total; locked
      "settle ₱X to continue" screen when previous day unsettled
- [ ] **Background GPS sharing** during active delivery (auto-start on pickup,
      stop on delivery)
- [ ] Simple earnings view

## Admin App

- [ ] **Add/edit stores** (no merchant login — admin owns all data)
- [ ] **Per-merchant on/off toggle** (open/closed/unavailable, independent of
      system hours)
- [ ] **Add/edit menus**: categories/groupings, items, prices, item options
- [ ] **Fee settings (all editable):** delivery fee, per-store fee (default ₱25),
      convenience fee, commission rate (default 15%)
- [ ] **Delivery fee model** (flat / distance / per-zone)
- [ ] **Rider management** — approve/reject applications, assign, monitor
- [ ] **Settlement management** — balances owed, who's locked, confirm/mark paid,
      settlement history
- [ ] **Payment settings** — configure COD + online (PayMongo/Xendit, GCash/Maya,
      rider QR)
- [ ] **Operating hours** on/off + schedule (system-wide)
- [ ] **Live order monitoring** + history

> End goal: replace the operator's manual monitoring burden.
