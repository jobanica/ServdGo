# @servdgo/shared

The shared TypeScript layer reused across the customer web/mobile apps, the rider
app, and the admin dashboard. Pure logic and types — no UI, no I/O.

## Modules

| Module | Exports |
|---|---|
| `pricing.ts` | `commission()`, `orderCost()`, `storeFeeTotal()`, `addedStores()`, `FeeConfig`, `DEFAULT_FEE_CONFIG` — the locked commission formula |
| `settlement.ts` | `owedBalance()`, `overdueBalance()`, `isLockedOut()`, `generatesSettlementBalance()` — the daily settlement gate |
| `types.ts` | Domain enums + `canTransition()` order-status state machine |
| `money.ts` | `roundPeso()` and centavo helpers (avoid float drift) |

## The commission formula

```
Commission = (Delivery Fee + perStoreFee × addedStores) × commissionRate
```

`addedStores = max(0, storeCount − 1)`; defaults ₱25 / 15%. Commission is on the
delivery + store fees only — goods cost is a pass-through. See
[`../../docs/commission-and-settlement.md`](../../docs/commission-and-settlement.md).

## Scripts

```bash
npm test        # node:test with native TS type-stripping (no build step)
npm run typecheck
```

The package is consumed as source (`main: ./src/index.ts`) — bundlers/apps
transpile it. No build output is committed.
