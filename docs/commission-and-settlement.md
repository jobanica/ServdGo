# Commission & Settlement

## The locked formula

```
Commission = (Delivery Fee + ₱25 × number of added stores) × 15%
```

Confirmed by the operator. All three inputs are **admin-set and editable**.

- The **delivery fee** and the **per-store fee (default ₱25)** are added together
  first, then multiplied by **15%**.
- **"Added stores"** = stores beyond the first. One rider services up to **3
  stores per trip**, so a 3-store order adds ₱25 × 2 = ₱50 into the base before
  the 15%.

### Worked example

| Input | Value |
|---|---|
| Delivery fee | ₱50 |
| Added stores | 2 (a 3-store order) |
| Store fee base | ₱25 × 2 = ₱50 |
| **Commission base** | ₱50 + ₱50 = **₱100** |
| **Commission (15%)** | **₱15** |

### The structural point

Commission is on the **delivery fee + store fees, NOT the food/goods cost.** The
cost of goods is a straight pass-through — the rider fronts it, the customer
repays it, the admin doesn't touch it.

### Reference pseudocode

```ts
function commission(deliveryFee: number, storeCount: number, opts: {
  perStoreFee?: number;   // default 25
  rate?: number;          // default 0.15
} = {}): number {
  const perStoreFee = opts.perStoreFee ?? 25;
  const rate = opts.rate ?? 0.15;
  const addedStores = Math.max(0, storeCount - 1);
  const base = deliveryFee + perStoreFee * addedStores;
  return base * rate;
}
```

## Convenience fee

A separate admin-set fee charged to the customer per order. It goes to the
**rider in full** — the operator takes **no commission** on it, so it never
enters the commission base. The customer pays it as part of their total; the
rider keeps it.

## Admin-configurable fees

All editable in the Admin App:

- **Delivery fee** — flat / per-km / per-zone (see open decision #3).
- **Per-store added fee** — default ₱25.
- **Convenience fee.**
- **Commission rate** — default 15%.

---

## Rider settlement (how the operator gets paid)

Because most orders are **COD, the rider physically holds the operator's
commission** — they collect the full amount from the customer, including the
delivery fee the commission is calculated on. The platform collects it through a
**daily settlement gate**:

1. Every completed order adds its commission to the rider's **running balance
   owed** (commission ledger).
2. At the **end of each day**, that balance becomes due.
3. The rider **must settle the previous day's balance before the account
   reactivates.** Until paid, the account is **locked** — no new orders.
4. Once settled and confirmed, the account **reactivates** and the balance resets
   to zero for the new day.

This guarantees the operator gets paid without chasing riders — the rider's
ability to earn tomorrow depends on settling today.

### Online payments don't add to the balance

When a customer pays **online**, money lands with the operator directly — there's
no commission for the rider to hold, so that order **must not** add to the rider's
owed balance. Only **COD orders** (and rider-personal-QR payments, if that route
is chosen) generate a settlement balance. A platform-routed QR keeps commission
off the rider's books entirely (see open decision #6).

### Build requirements

- **Per-rider commission ledger** — every order's commission logged, running
  total, settled/unsettled state.
- **Daily cutoff time** — when the day rolls over and the balance becomes due
  (e.g. midnight or start of next operating day). Configurable. *(Open decision #4.)*
- **Account lock logic** — a rider with an unsettled previous-day balance is
  auto-locked; a clear "settle ₱X to continue" screen in the Rider App.
- **Settlement method** — how the rider pays (GCash/Maya to operator's number,
  cash drop, bank), then admin **confirms** (manual mark-as-paid) or auto-verify
  via payment reference. *(Open decision #4.)*
- **Admin view** — who owes what, who's locked, settlement history,
  mark-as-settled action.
