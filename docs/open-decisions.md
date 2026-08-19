# Open Decisions

Track these before / while building. Recommendations noted where the spec gives one.

| # | Decision | Options | Recommendation / status |
|---|---|---|---|
| 1 | **Commission formula** | — | ✅ **RESOLVED:** `(Delivery Fee + ₱25 × added stores) × 15%` |
| 2 | **Convenience fee treatment** | Inside the 15% base, or flat pass-through to admin | **Flat pass-through** (simpler, more common) unless operator says otherwise |
| 3 | **Delivery fee model** | Flat, per-km, or per-zone | Open — affects both the customer quote and the 15% math |
| 4 | **Rider float / cash risk** | — | Define: **daily cutoff time** for settlement; **settlement method** (GCash/cash/bank) + manual-confirm vs auto-verify; **cancellation/no-show policy** (rider out real cash if customer cancels after pickup or refuses at door) |
| 5 | **Pabili over-budget** | — | ✅ **IMPLEMENTED (confirm at cap):** the estimate→cap gap is the buffer; the rider may spend up to the **cap** without asking. Actual **over the cap** flags `overCap` so the app prompts for customer confirmation before collecting. Confirm the exact confirmation UX with the operator |
| 6 | **Online payment provider** | PayMongo vs Xendit vs direct GCash/Maya | ⚙️ **STRUCTURE BUILT (provider still to pick):** three methods modelled — `cod` (rider collects full, generates settlement balance), `online` (platform/delivery portion prepaid to operator; rider collects only fronted goods; **no** settlement balance), `rider_qr` (paid to rider via QR; collects nothing at door but **still** holds commission). Real PayMongo/Xendit wiring needs API keys; the rider QR encodes a placeholder `ebd://pay` payload |
| 7 | **Rider assignment** | First-come-accept (open pool), admin-assigned, or nearest-rider auto-dispatch | Open |
| 8 | **Customer accounts** | Full signup, or phone + OTP lightweight | ✅ **BUILT (phone OTP):** Supabase Auth phone OTP for customer + rider. A signup trigger (`0008`) creates the profile; `ensureCustomer`/`ensureRider` link the domain row; RLS then filters orders/pool by the session. **Needs an SMS provider** configured on the project (Auth → Providers → Phone) to deliver codes in production |
| 9 | **Live tracking transport** | Supabase Realtime (rider lat/lng every few sec) vs lightweight websocket | ⚙️ **BUILT (map tiles still to pick):** Supabase Realtime broadcast on a per-order channel, **4s** interval (`TRACKING_INTERVAL_MS`); rider publishes only in transit (auto-start on pickup, stop on delivery). Customer map is a self-contained SVG for now — swap for **Mapbox / Leaflet + OSM** (near-zero cost) or Google (best PH coverage) via the same `useTracking` feed |

## Notes on the cash-risk decisions (#4)

The rider fronts real money for goods **and** holds the operator's commission
until daily settlement. The unresolved pieces:

- **Daily cutoff time** — when "the day" rolls over and yesterday's balance
  becomes due (midnight vs start of next operating day).
- **Settlement payment method** — GCash/Maya to operator's number, cash drop, or
  bank; then admin manual-confirm or auto-verify by reference.
- **Cancellation / no-show policy** — what happens when a customer cancels after
  pickup or refuses to pay at the door and the rider is out real cash.

## Notes on payment routing (#6)

- **Personal rider QR** → money lands on the rider → that order **still generates
  a settlement balance** (rider holds operator's cut).
- **Platform-routed QR** → money lands on the operator → **no settlement balance**
  for that order (like any online payment).

This choice interacts directly with the settlement ledger (see
[commission-and-settlement.md](commission-and-settlement.md)).
